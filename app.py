import asyncio
import io
import json
import os
import re
import subprocess
import sys
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, AsyncGenerator

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

load_dotenv()
APP_NAME = os.getenv("APP_NAME", "AI Canvas")
BASE_URL = os.getenv("BASE_URL", "https://freemodelsforall.hopto.org/v1").rstrip("/")
API_KEY = os.getenv("API_KEY") or os.getenv("OPENAI_API_KEY")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "obsidianx/openai/gpt-5-6-luna")
WORKSPACE_ROOT = Path(os.getenv("WORKSPACE_ROOT", "./workspace")).resolve()
MAX_FILE_BYTES = int(os.getenv("MAX_FILE_BYTES", str(25 * 1024 * 1024)))
MAX_TOOL_ROUNDS = int(os.getenv("MAX_TOOL_ROUNDS", "16"))
CODE_TIMEOUT = int(os.getenv("CODE_TIMEOUT_SECONDS", "20"))
ENABLE_CODE_EXECUTION = os.getenv("ENABLE_CODE_EXECUTION", "true").lower() == "true"
WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)

FALLBACK_MODELS = [
("Claude Fable 5","obsidianx/custom/claude-fable-5"),("Gpt 5 4","obsidianx/openai/gpt-5-4"),("Gpt 5 5","obsidianx/openai/gpt-5-5"),("Gpt 5 6 Luna","obsidianx/openai/gpt-5-6-luna"),("Gpt 5 6 Terra","obsidianx/openai/gpt-5-6-terra"),("Gpt 5.6","obsidianx/openai/gpt-5.6"),("Claude Opus 5","obsidianx/custom/claude-opus-5"),("Claude Sonnet 5","obsidianx/custom/claude-sonnet-5"),("DeepSeek V4 Pro","obsidianx/openai/deepseek-v4-pro"),("Gemini 3 Pro","obsidianx/custom/gemini-3-pro"),("Grok 4 5","obsidianx/custom/grok-4-5"),("Longcat 2.0 Free","obsidianx/custom/longcat-2.0-free"),("North Mini Code Free","obsidianx/custom/north-mini-code-free")]

AGENT_SYSTEM_PROMPT = """You are the reasoning and execution engine inside AI Canvas, an agentic AI workspace. Behave like a careful senior human expert and an autonomous task agent, not a one-shot chatbot.

CORE BEHAVIOR
- Understand the user's real objective before acting. For complex requests, silently make a practical plan and execute it step by step.
- Use tools whenever they materially improve correctness: inspect files, search the workspace, create/edit files, run Python when useful, and verify results.
- Do not claim you read, ran, created, downloaded, verified, or inspected something unless the tool result proves it.
- After a tool action, inspect its result and decide the next action. Continue until the task is actually complete or a real external limitation blocks it.
- Prefer verification over guessing. When calculations, code, file transformations, or factual details can be checked, check them.
- If something is uncertain, say exactly what is uncertain instead of inventing certainty. Never promise 100% accuracy; maximize accuracy through verification.
- Keep the final response coherent, polished, natural, and human-sounding. Do not emit broken fragments, fake stream artifacts, raw tool-call syntax, internal instructions, hidden reasoning, or unnecessary status chatter.
- Explain the result in a way a competent human colleague would: direct, context-aware, precise, and useful. Use headings/bullets when they improve readability, not mechanically.
- Do not repeat the user's prompt unnecessarily. Do not add generic filler or fake enthusiasm.
- When the user asks for a deliverable, actually create it with the output-file tool and give the exact output path.
- For uploaded files, identify the relevant files first. Use file inspection/extraction tools before making claims about their contents.
- When editing files, preserve important existing structure unless the user explicitly asks for a rewrite. Re-read or inspect after modification when practical.
- For multi-step work, maintain state through the workspace. Intermediate working files belong in files/; final user-facing deliverables belong in outputs/.
- Never delete or overwrite important user files unless the user clearly requested it.

RESPONSE QUALITY
Write complete sentences and connected paragraphs. Streamed tokens are only a transport mechanism: the user should perceive one continuous, finished answer. Be concise when the task is simple and detailed when the task is complex. Match the user's language when practical. Never fabricate citations, sources, results, or capabilities.

AGENT LOOP
Plan -> inspect -> act -> observe -> verify -> fix/retry -> deliver. Stop only when the requested outcome is complete, when a necessary capability is unavailable, or when user approval is genuinely required.
"""

TOOLS_SCHEMA = [
 {"type":"function","function":{"name":"write_file","description":"Create or overwrite a UTF-8 working/source file inside the current chat workspace. Use files/ for intermediate artifacts. Never use this for final user-facing deliverables when write_output_file is appropriate.","parameters":{"type":"object","properties":{"filepath":{"type":"string","description":"Relative path inside workspace."},"content":{"type":"string","description":"UTF-8 content."}},"required":["filepath","content"]}}},
 {"type":"function","function":{"name":"write_output_file","description":"Create a final downloadable deliverable inside outputs/. Supports text/source formats such as md, txt, json, csv, html, py, js, css and similar files.","parameters":{"type":"object","properties":{"filename":{"type":"string","description":"Output filename including extension."},"content":{"type":"string","description":"UTF-8 file content."}},"required":["filename","content"]}}},
 {"type":"function","function":{"name":"delete_file","description":"Delete a file inside the current chat workspace. Use only when clearly required by the user's request.","parameters":{"type":"object","properties":{"filepath":{"type":"string"}},"required":["filepath"]}}},
 {"type":"function","function":{"name":"read_file","description":"Read a file from the current chat workspace. Text files are read directly; PDF, DOCX, XLSX and CSV files are extracted when supported.","parameters":{"type":"object","properties":{"filepath":{"type":"string"}},"required":["filepath"]}}},
 {"type":"function","function":{"name":"search_files","description":"Search filenames and text-readable workspace files for a keyword or phrase. Use this before opening many files or when locating relevant uploaded material.","parameters":{"type":"object","properties":{"query":{"type":"string"},"directory":{"type":"string","default":"."}},"required":["query"]}}},
 {"type":"function","function":{"name":"list_directory","description":"List files and folders inside the current chat workspace, including uploads/ and outputs/.","parameters":{"type":"object","properties":{"directory":{"type":"string","default":"."}},"required":[]}}},
 {"type":"function","function":{"name":"run_python","description":"Run a short Python program in the current chat workspace for calculations, data processing, validation, or generating files. Execution is time-limited and intended for the user's task.","parameters":{"type":"object","properties":{"code":{"type":"string"},"timeout":{"type":"integer","minimum":1,"maximum":60}},"required":["code"]}}}
]

app = FastAPI(title=APP_NAME, version="4.0.0")
app.mount("/static", StaticFiles(directory="static"), name="static")

class ChatRequest(BaseModel):
    chat_id: str = Field(default="default", min_length=1, max_length=100)
    model: str = Field(default=DEFAULT_MODEL, min_length=1, max_length=200)
    messages: list[dict[str, Any]] = Field(default_factory=list)
    tools_enabled: bool = True

class DownloadRequest(BaseModel):
    chat_id: str = Field(min_length=1, max_length=100)
    title: str = Field(default="AI Canvas Chat", max_length=200)
    messages: list[dict[str, Any]] = Field(default_factory=list)

def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

def chat_root(chat_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", chat_id): raise ValueError("Invalid chat id")
    root = (WORKSPACE_ROOT / "chats" / chat_id).resolve()
    if WORKSPACE_ROOT not in root.parents: raise ValueError("Invalid chat workspace")
    for d in ("uploads","outputs","files"): (root/d).mkdir(parents=True, exist_ok=True)
    return root

def safe_path(root: Path, relative: str) -> Path:
    relative=(relative or "").strip().replace("\\","/")
    if not relative: raise ValueError("A relative path is required.")
    candidate=(root/relative).resolve()
    if candidate != root and root not in candidate.parents: raise ValueError("Path escapes the workspace.")
    return candidate

def extract_file(path: Path) -> str:
    ext=path.suffix.lower()
    if ext in {".txt",".md",".py",".js",".ts",".tsx",".jsx",".html",".css",".json",".csv",".xml",".yaml",".yml",".toml",".ini",".log",".sql",".sh",".c",".cpp",".java",".rs",".go"}:
        return path.read_text(encoding="utf-8",errors="replace")
    if ext==".pdf":
        from pypdf import PdfReader
        r=PdfReader(str(path)); return "\n\n".join((p.extract_text() or "") for p in r.pages)
    if ext==".docx":
        from docx import Document
        d=Document(str(path)); return "\n".join(p.text for p in d.paragraphs)
    if ext==".xlsx":
        from openpyxl import load_workbook
        wb=load_workbook(str(path),read_only=True,data_only=True); chunks=[]
        for ws in wb.worksheets:
            chunks.append(f"[Sheet: {ws.title}]")
            for row in ws.iter_rows(values_only=True): chunks.append("\t".join("" if v is None else str(v) for v in row))
        return "\n".join(chunks)
    raise ValueError(f"Unsupported text extraction format: {ext or 'unknown'}")

def execute_tool(name: str, arguments: str, chat_id: str) -> str:
    try: args=json.loads(arguments) if arguments.strip() else {}
    except json.JSONDecodeError as exc: return f"Error: invalid tool arguments JSON: {exc}"
    try:
        root=chat_root(chat_id)
        if name=="write_file":
            path=safe_path(root,args.get("filepath","")); content=str(args.get("content",""))
            if len(content.encode())>MAX_FILE_BYTES:return "Error: file exceeds size limit."
            path.parent.mkdir(parents=True,exist_ok=True); path.write_text(content,encoding="utf-8"); return f"Success: wrote '{path.relative_to(root)}'."
        if name=="write_output_file":
            filename=Path(str(args.get("filename","output.txt"))).name
            if not filename or filename.startswith("."):filename="output.txt"
            path=root/"outputs"/filename; content=str(args.get("content",""))
            if len(content.encode())>MAX_FILE_BYTES:return "Error: output exceeds size limit."
            path.write_text(content,encoding="utf-8"); return f"Success: final output saved as 'outputs/{filename}'."
        if name=="delete_file":
            path=safe_path(root,args.get("filepath",""))
            if not path.exists() or not path.is_file():return "Error: file not found."
            path.unlink();return f"Success: deleted '{path.relative_to(root)}'."
        if name=="read_file":
            path=safe_path(root,args.get("filepath",""))
            if not path.is_file():return "Error: file not found."
            if path.stat().st_size>MAX_FILE_BYTES:return "Error: file exceeds size limit."
            try:return extract_file(path)
            except Exception as exc:return f"Error extracting '{path.relative_to(root)}': {exc}"
        if name=="search_files":
            query=str(args.get("query","")).lower().strip(); base=safe_path(root,args.get("directory",".")) if args.get("directory") not in (None,"", ".") else root
            if not query:return "Error: query is required."
            hits=[]
            for p in base.rglob("*"):
                if not p.is_file():continue
                rel=p.relative_to(root).as_posix()
                if query in p.name.lower():hits.append({"file":rel,"match":"filename"});continue
                if p.stat().st_size>MAX_FILE_BYTES:continue
                try:
                    text=extract_file(p)
                    pos=text.lower().find(query)
                    if pos>=0:hits.append({"file":rel,"match":text[max(0,pos-120):pos+len(query)+240]})
                except Exception:pass
                if len(hits)>=50:break
            return json.dumps(hits,ensure_ascii=False,indent=2)
        if name=="list_directory":
            path=safe_path(root,args.get("directory",".")) if args.get("directory") not in (None,"", ".") else root
            if not path.is_dir():return "Error: directory not found."
            items=[]
            for item in sorted(path.iterdir(),key=lambda p:(not p.is_dir(),p.name.lower())):items.append({"name":item.name,"type":"directory" if item.is_dir() else "file","size":item.stat().st_size if item.is_file() else None})
            return json.dumps(items,ensure_ascii=False,indent=2)
        if name=="run_python":
            if not ENABLE_CODE_EXECUTION:return "Error: Python execution is disabled by server configuration."
            code=str(args.get("code","")); timeout=min(max(int(args.get("timeout",CODE_TIMEOUT)),1),60)
            proc=subprocess.run([sys.executable,"-I","-c",code],cwd=str(root),capture_output=True,text=True,timeout=timeout,env={"PATH":os.getenv("PATH","")})
            out=(proc.stdout or "")+("\n[stderr]\n"+proc.stderr if proc.stderr else "")
            return f"Exit code: {proc.returncode}\n{out[-20000:]}"
        return f"Error: unknown tool '{name}'."
    except subprocess.TimeoutExpired:return "Error: Python execution timed out."
    except Exception as exc:return f"Error executing {name}: {exc}"

async def get_models(client: AsyncOpenAI)->list[str]:
    try:
        response=await client.models.list(); ids=sorted({m.id for m in response.data if getattr(m,"id",None)}); return ids or [x[1] for x in FALLBACK_MODELS]
    except Exception:return [x[1] for x in FALLBACK_MODELS]

def build_messages(raw:list[dict[str,Any]])->list[dict[str,Any]]:
    cleaned=[]
    for m in raw:
        role=m.get("role")
        if role in {"user","assistant","tool"}: cleaned.append(m)
    return [{"role":"system","content":AGENT_SYSTEM_PROMPT}]+cleaned

async def stream_chat(req:ChatRequest)->AsyncGenerator[str,None]:
    if not API_KEY:yield sse("error",{"message":"API_KEY is not configured on the server."});return
    client=AsyncOpenAI(base_url=BASE_URL,api_key=API_KEY); messages=build_messages(req.messages); model=req.model.strip(); tools_enabled=req.tools_enabled
    yield sse("status",{"message":"Agent is planning and connecting…","model":model})
    for round_index in range(MAX_TOOL_ROUNDS):
        kwargs={"model":model,"messages":messages,"stream":True}
        if tools_enabled:kwargs["tools"]=TOOLS_SCHEMA
        try:
            response=await client.chat.completions.create(**kwargs); assistant_text=""; tool_calls={}
            async for chunk in response:
                if not chunk.choices:continue
                delta=chunk.choices[0].delta; content=getattr(delta,"content",None)
                if content:assistant_text+=content;yield sse("token",{"text":content})
                incoming=getattr(delta,"tool_calls",None)
                if incoming:
                    for tc in incoming:
                        idx=getattr(tc,"index",0); entry=tool_calls.setdefault(idx,{"id":None,"name":"","arguments":""})
                        if getattr(tc,"id",None):entry["id"]=tc.id
                        fn=getattr(tc,"function",None)
                        if fn:
                            if getattr(fn,"name",None):entry["name"]=fn.name
                            if getattr(fn,"arguments",None):entry["arguments"]+=fn.arguments
            if not tool_calls:
                yield sse("done",{"round":round_index+1});return
            serialized=[]
            for idx in sorted(tool_calls):
                tc=tool_calls[idx];serialized.append({"id":tc["id"] or f"call_{uuid.uuid4().hex}","type":"function","function":{"name":tc["name"],"arguments":tc["arguments"]}})
            messages.append({"role":"assistant","content":assistant_text or None,"tool_calls":serialized})
            for tc in serialized:
                name=tc["function"]["name"];args=tc["function"]["arguments"];yield sse("tool_start",{"name":name,"arguments":args});result=await asyncio.to_thread(execute_tool,name,args,req.chat_id);yield sse("tool_result",{"name":name,"result":result[:6000]});messages.append({"role":"tool","tool_call_id":tc["id"],"name":name,"content":result})
        except Exception as exc:
            error=str(exc)
            if tools_enabled and any(x in error.lower() for x in ("tool","invalid_request_error")):
                tools_enabled=False;yield sse("status",{"message":"This model rejected tool calling; retrying in text mode…"});continue
            yield sse("error",{"message":error});return
    yield sse("error",{"message":f"Agent reached its safety limit of {MAX_TOOL_ROUNDS} execution rounds before completion."})

@app.get("/",response_class=HTMLResponse)
async def index():return Path("static/index.html").read_text(encoding="utf-8")
@app.get("/api/health")
async def health():return {"ok":True,"app":APP_NAME,"api_configured":bool(API_KEY),"agent":True,"tool_rounds":MAX_TOOL_ROUNDS,"timestamp":int(time.time())}
@app.get("/api/models")
async def models():
    if not API_KEY:return {"models":[x[1] for x in FALLBACK_MODELS],"source":"fallback","api_configured":False}
    ids=await get_models(AsyncOpenAI(base_url=BASE_URL,api_key=API_KEY));return {"models":ids,"source":"gateway","api_configured":True}
@app.post("/api/chat/stream")
async def chat_stream(req:ChatRequest):
    if not req.messages:raise HTTPException(400,"messages cannot be empty")
    chat_root(req.chat_id);return StreamingResponse(stream_chat(req),media_type="text/event-stream",headers={"Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"})
@app.post("/api/upload")
async def upload(chat_id:str=Form(...),files:list[UploadFile]=File(...)):
    root=chat_root(chat_id);saved=[]
    for upload in files:
        name=Path(upload.filename or "file").name
        if not name:continue
        data=await upload.read()
        if len(data)>MAX_FILE_BYTES:raise HTTPException(413,f"{name} exceeds MAX_FILE_BYTES")
        target=root/"uploads"/f"{uuid.uuid4().hex[:8]}_{name}";target.write_bytes(data);saved.append({"name":name,"stored":str(target.relative_to(root)),"size":len(data),"type":upload.content_type or "application/octet-stream"})
    return {"files":saved}
@app.post("/api/download")
async def download(req:DownloadRequest):
    root=chat_root(req.chat_id);buf=io.BytesIO();safe_title=re.sub(r"[^A-Za-z0-9._-]+","_",req.title).strip("._-") or "AI_Canvas_Chat"
    with zipfile.ZipFile(buf,"w",zipfile.ZIP_DEFLATED) as z:
        lines=[f"# {req.title}","",f"Exported: {time.strftime('%Y-%m-%d %H:%M:%S UTC',time.gmtime())}",""]
        for m in req.messages:
            role=str(m.get("role","unknown")).capitalize();content=m.get("content","")
            if isinstance(content,list):content=json.dumps(content,ensure_ascii=False,indent=2)
            lines += [f"## {role}","",str(content),""]
        z.writestr("conversation.md","\n".join(lines))
        for folder in ("uploads","outputs","files"):
            base=root/folder
            if base.exists():
                for p in base.rglob("*"):
                    if p.is_file():z.write(p,p.relative_to(root).as_posix())
        manifest={"title":req.title,"chat_id":req.chat_id,"agent_runtime":"AI Canvas Agent v4","files":{}}
        for folder in ("uploads","outputs","files"):
            base=root/folder;manifest["files"][folder]=[p.relative_to(root).as_posix() for p in base.rglob("*") if p.is_file()] if base.exists() else []
        z.writestr("manifest.json",json.dumps(manifest,ensure_ascii=False,indent=2))
    return Response(buf.getvalue(),media_type="application/zip",headers={"Content-Disposition":f'attachment; filename="{safe_title}.zip"'})

if __name__=="__main__":
    import uvicorn
    uvicorn.run(app,host="0.0.0.0",port=int(os.getenv("PORT","8000")))
