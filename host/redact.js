// Credential redaction for captured HTTP traffic.
//
// The extension records each request's URL and postData and each response's
// body (see extension/src/background.js). It does NOT capture request or
// response headers, so Cookie / Set-Cookie / Authorization headers never reach
// the agent. The remaining credential surface is:
//   - secret-shaped query parameters in the URL (?token=..., ?access_token=...)
//   - secret-shaped fields in request bodies (form-encoded or JSON logins)
//   - tokens embedded in response bodies (e.g. an auth endpoint's JSON)
//
// By default browser_capture_requests masks the values of secret-shaped keys
// in all three places while leaving everything else intact, so the traffic
// stays useful for debugging without piping live credentials into the model.
// Set the plugin's `redactCredentials: false` config to disable this.
//
// Redaction is an allowlist and fails closed. An unrecognisable reply envelope
// throws; the envelope and every entry are then projected onto their allowlists
// (KNOWN_ENVELOPE_FIELDS / KNOWN_ENTRY_FIELDS), so a field this module does not
// know is dropped rather than forwarded unmasked, and named in the sibling
// `droppedFields`. The fast-path pre-filter is DERIVED from the same key-name
// list as the matcher, so it cannot narrow what gets masked.
//
// Captured bodies are page-controlled input on the host's single event loop:
// every pattern applied to them must be linear. A nested-quantifier shape check
// here once backtracked for tens of seconds on a ~90-byte body and stalled dsh.

const REDACTED = "«redacted»";

// Key names whose *values* are treated as secrets. Written once, here, and
// used to build BOTH regexes below — the fast-path pre-filter has to be a
// superset of the authority, and deriving them from one string makes that true
// by construction instead of a comment somebody has to honour.
//
// The `(?![a-z])` guards keep the unanchored pre-filter build from matching
// ordinary English: without them `sig`/`sid`/`auth`/`session` fire on design,
// consider, inside, author, president… and drag every such body onto the slow
// path. They cost the anchored build nothing (it already ends in `$`).
// (`access[_-]?token` &co. are spelled out because the separator is optional:
//  `access_token` is already covered by the bare `token` alternative via the
//  `[_-]` prefix, but `accesstoken` is not.)
const SECRET_KEY_NAMES = String.raw`token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|pwd|api[_-]?key|auth(?:orization)?(?![a-z])|session(?:id)?(?![a-z])|sid(?![a-z])|cookie|credential|client[_-]?secret|private[_-]?key|signature(?![a-z])|sig(?![a-z])`;

// The authority: a whole key name (or its trailing `_`/`-` segment) is a secret.
// Matches against DECODED keys — see redactPairs / redactJson.
const SECRET_KEY = new RegExp(String.raw`(?:^|[_-])(?:${SECRET_KEY_NAMES})$`, "i");

// Cheap pre-filter over a whole body: could anything in here be a secret key?
// Dropping the anchors can only widen the match, so a "no" here is a reliable
// "no" from SECRET_KEY, and the body can skip parsing entirely.
//
// Keys reach isSecretKey DECODED, so escapes must be accounted for too:
// `%74oken=…` and `{"token":…}` both decode to `token`. Only escapes that
// can produce a character legal in a key name (`[A-Za-z0-9_-]`) matter, so the
// alternatives below are narrow on purpose — matching every `\uXXXX` would put
// the slow path back on ordinary traffic, since Go escapes `<>&` by default and
// Python's json.dumps escapes all non-ASCII.
const KEY_CHAR_ESCAPE = String.raw`%(?:2[dD]|3[0-9]|[4-7][0-9a-fA-F])|\\u00(?:2[dD]|3[0-9]|[4-7][0-9a-fA-F])`;
const MENTIONS_SECRET = new RegExp(`${SECRET_KEY_NAMES}|${KEY_CHAR_ESCAPE}`, "i");

function isSecretKey(key) {
  if (typeof key !== "string") return false;
  // No `SECRET_KEY.test("_" + key)` companion check: SECRET_KEY already starts
  // with `(?:^|[_-])`, so prefixing "_" can only re-match what `^` matched.
  return SECRET_KEY.test(key);
}

/**
 * Mask secret values in an `a=1&b=2` pair string. Shared by the URL query and
 * the form-body paths so masking semantics (separators, %-decoding, which half
 * is masked) can only ever be changed in one place.
 */
function redactPairs(pairs) {
  return pairs
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      let decoded;
      try {
        decoded = decodeURIComponent(key);
      } catch {
        decoded = key; // malformed %-encoding: fall back to the raw key
      }
      return isSecretKey(decoded) ? `${key}=${REDACTED}` : pair;
    })
    .join("&");
}

/** Mask secret query-parameter values in a URL, leaving the rest readable. */
export function redactUrl(url) {
  if (typeof url !== "string" || !url.includes("?")) return url;
  const qIndex = url.indexOf("?");
  const base = url.slice(0, qIndex);
  const [query, hash = ""] = url.slice(qIndex + 1).split("#");
  return base + "?" + redactPairs(query) + (hash ? "#" + hash : "");
}

/**
 * Mask secret values inside a parsed JSON value.
 *
 * Returns the SAME object when nothing below it changed, so callers can detect
 * a clean body by identity and skip re-stringifying it — the common case for a
 * body that only tripped the pre-filter on a false positive.
 */
function redactJson(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = redactJson(v);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (isSecretKey(k)) {
        out[k] = REDACTED;
        changed = true;
      } else {
        const r = redactJson(v);
        if (r !== v) changed = true;
        out[k] = r;
      }
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * Mask secret fields in a request/response body string. Handles JSON objects
 * and URL-encoded form bodies; anything else is returned unchanged (we do not
 * guess at arbitrary blobs).
 */
export function redactBody(body) {
  if (typeof body !== "string" || body.length === 0) return body;
  // Bail before parsing when nothing in the blob could be a secret key.
  // Captured bodies routinely run to the 1 MB cap, and parse + clone +
  // re-stringify costs ~100x this scan — on a payload we'd hand back unchanged.
  if (!MENTIONS_SECRET.test(body)) return body;
  const trimmed = body.trim();

  // JSON body. Bodies cut at the capture cap are truncated mid-token, so their
  // JSON.parse is guaranteed to fail after scanning the whole megabyte — check
  // the closing delimiter first rather than paying for that on every entry.
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "{" && last === "}") || (first === "[" && last === "]")) {
    try {
      const parsed = JSON.parse(trimmed);
      const redacted = redactJson(parsed);
      // Nothing matched → hand back the original text rather than a
      // re-serialized copy (which would also reformat the caller's body).
      return redacted === parsed ? body : JSON.stringify(redacted);
    } catch {
      // fall through to form handling / passthrough
    }
  }

  // URL-encoded form body (key=value&key=value), no whitespace, at least one
  // '='. Checked with two linear scans, NOT a regex: the obvious shape regex
  // (`^[^\s]*=[^\s]*(?:&[^\s]*=[^\s]*)*$`) nests quantifiers that also match
  // the separators, so a ~90-byte form-ish body with trailing whitespace
  // backtracked for tens of seconds and stalled the whole dsh host.
  if (!/\s/.test(trimmed) && trimmed.includes("=")) {
    return redactPairs(trimmed);
  }

  return body;
}

/**
 * Copy only the allowed keys of `obj`; everything else is dropped and named in
 * `droppedFields`. This is the shape of the whole fail-closed contract, so it
 * lives in one place — both the reply envelope and each capture entry use it,
 * and any change to how omissions are reported lands in a single loop.
 */
function projectKnown(obj, allowed) {
  const out = {};
  const dropped = [];
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) out[key] = obj[key];
    else dropped.push(key);
  }
  if (dropped.length) out.droppedFields = dropped;
  return out;
}

// Envelope fields the extension replies with (see the capture_requests case in
// extension/src/background.js). Like the per-entry allowlist below, anything
// outside this set is dropped rather than forwarded: a future envelope-level
// field could just as easily carry a URL or a body.
const KNOWN_ENVELOPE_FIELDS = new Set(["tabId", "capturing", "count", "entries"]);

/**
 * Redact a browser_capture_requests result. The extension replies with
 * {tabId, capturing, count, entries: [...]}. Fail closed: an envelope without a
 * recognisable `entries` array throws rather than passing traffic through
 * unredacted, and any *extra* envelope field is dropped (never forwarded
 * unmasked) and named in `droppedFields` — so no reply-shape change can
 * silently bypass masking while the tool still promises «redacted».
 */
export function redactCaptureResult(result) {
  // (An array's `.entries` is Array.prototype.entries, a function, so the
  // Array.isArray check below also rejects a bare array.)
  if (!result || typeof result !== "object" || !Array.isArray(result.entries)) {
    throw new Error(
      "capture_requests returned an unexpected shape; refusing to pass it through unredacted"
    );
  }
  const out = projectKnown(result, KNOWN_ENVELOPE_FIELDS);
  out.entries = result.entries.map(redactEntry);
  return out;
}

// Fields the extension records per capture entry (see the Network.* handlers
// in extension/src/background.js). Redaction is an allowlist: url/postData/body
// are masked, the rest are non-credential metadata copied as-is.
const KNOWN_ENTRY_FIELDS = new Set([
  "id",
  "seq",
  "method",
  "url",
  "type",
  "postData",
  "status",
  "mimeType",
  "body",
  "time",
  "redirect",
]);

/**
 * Redact one capture entry (url, postData, body). Returns a new object.
 *
 * Fails closed by projection rather than by throwing: the extension and the
 * host plugin update independently, so an extension that starts recording a
 * new per-entry field is normal version skew. Such a field is DROPPED (never
 * forwarded unmasked) and named in `droppedFields`, so capture keeps working
 * and the omission is visible — instead of the whole tool erroring out
 * because of one unrecognised piece of metadata.
 */
export function redactEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("capture entry is not an object; refusing to pass it through unredacted");
  }
  const out = projectKnown(entry, KNOWN_ENTRY_FIELDS);
  if (typeof out.url === "string") out.url = redactUrl(out.url);
  if (typeof out.postData === "string") out.postData = redactBody(out.postData);
  if (typeof out.body === "string") out.body = redactBody(out.body);
  return out;
}
