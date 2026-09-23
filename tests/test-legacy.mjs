// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
class El {
  constructor(id){this.id=id;this.value="";this.disabled=false;this._text="";this.children=[];this.handlers={};this.style={setProperty(){}};}
  set textContent(v){this._text=String(v);this.children=[];}
  get textContent(){return this._text;}
  appendChild(c){this.children.push(c);}
  addEventListener(t,h){(this.handlers[t] ||= []).push(h);}
  fire(t){for(const h of this.handlers[t]||[])h({target:this});}
  focus(){} select(){}
}
const els=new Map(); const el=(id)=>{if(!els.has(id))els.set(id,new El(id));return els.get(id);};
globalThis.document={getElementById:(id)=>el(id),createElement:(t)=>new El(t),documentElement:{style:{setProperty(){}}}};
globalThis.window={confirm:()=>true,setTimeout:(f,m)=>setTimeout(f,m)};

// 预置「旧版」storage：单一自定义槽 id 固定为 "custom"
const store={ insight_preset:"custom", insight_system:"OLD_CUSTOM_TEXT", insight_label:"解读" };
globalThis.chrome={storage:{local:{
  get:async(keys)=>{const l=Array.isArray(keys)?keys:[keys];const o={};for(const k of l)if(k in store)o[k]=store[k];return o;},
  set:async(o)=>{Object.assign(store,o);}},onChanged:{addListener(){}}}};
globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,maxSystem:4000,defaultSystem:"HOST_DEFAULT",
  presets:[{id:"default",name:"默认解读",system:"HOST_DEFAULT"}]})});

await import(pathToFileURL(`${SRC_DIR}/options.js`).href + "?legacy=1");
await new Promise(r=>setTimeout(r,80));

const labels=el("preset").children.map(c=>c.textContent);
const ok1 = store.insight_custom?.length===1 && store.insight_custom[0].system==="OLD_CUSTOM_TEXT";
const ok2 = labels.includes("自定义口径");
const ok3 = el("system").value==="OLD_CUSTOM_TEXT";
console.log(ok1?"  ok   旧 custom 槽已迁移成自定义口径":`  FAIL 迁移 ${JSON.stringify(store.insight_custom)}`);
console.log(ok2?"  ok   下拉里出现迁移后的口径":`  FAIL 下拉 ${JSON.stringify(labels)}`);
console.log(ok3?"  ok   编辑器载入旧文案":`  FAIL 编辑器 ${el("system").value}`);
process.exit(ok1&&ok2&&ok3?0:1);
