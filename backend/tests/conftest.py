import os
import sys

# Tests never need a real Redis, Docker daemon or LLM key.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("CORS_ORIGINS", "https://app.example.com")
os.environ.setdefault("LOG_FORMAT", "text")
