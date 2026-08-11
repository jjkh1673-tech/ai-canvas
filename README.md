# AI Canvas — Final Agentic Railway Build

A Railway-ready FastAPI + browser AI workspace with an agent runtime, tool orchestration, file extraction, optional Python execution, streaming UI, chat history, rename/search, and ZIP workspace export.

## Required variables
- `API_KEY`
- `BASE_URL` (default: https://freemodelsforall.hopto.org/v1)
- `DEFAULT_MODEL` (optional)

## Optional variables
- `MAX_TOOL_ROUNDS` default 16
- `MAX_FILE_BYTES` default 25MB
- `CODE_TIMEOUT_SECONDS` default 20
- `ENABLE_CODE_EXECUTION` default true

The runtime cannot guarantee literal 100% factual accuracy; it is designed to maximize accuracy through planning, tool use, verification, retries, and explicit uncertainty. Model capabilities still depend on the connected gateway/model.
