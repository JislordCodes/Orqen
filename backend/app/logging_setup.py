"""Logging for the API and the worker. LOG_FORMAT=json writes one JSON object per line
(CloudWatch Logs Insights can query the fields); LOG_FORMAT=text keeps the readable dev format."""
import json
import logging
import sys
import time

from . import config

_STD = set(vars(logging.LogRecord("", 0, "", 0, "", (), None))) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "service": self.service,
            "msg": record.getMessage(),
        }
        # Anything passed with logging's extra={...} becomes a top-level field.
        for k, v in record.__dict__.items():
            if k not in _STD and not k.startswith("_"):
                out[k] = v if isinstance(v, (str, int, float, bool, type(None))) else str(v)
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, ensure_ascii=False)


def setup(service: str) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    h = logging.StreamHandler(sys.stdout)
    if config.LOG_FORMAT == "json":
        h.setFormatter(JsonFormatter(service))
    else:
        h.setFormatter(logging.Formatter(f"%(asctime)s %(levelname)s [{service}] %(name)s: %(message)s"))
    root.addHandler(h)
    root.setLevel(config.LOG_LEVEL.upper())
    # uvicorn installs its own handlers; route them through ours so every line has one format.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True
