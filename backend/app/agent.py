"""Builds the Strands agents for a run: a PLANNER or a BUILDER (see harness.py).
The model, the system prompt, the tools, context management and streaming live here."""
import os
import time

from strands import Agent
from strands.agent.conversation_manager import SummarizingConversationManager
from strands.models.openai import OpenAIModel
from strands.session.file_session_manager import FileSessionManager

from . import config, harness
from .events import RunContext
from .tools import build_tools

# Kept for anyone importing it: the builder prompt is the old "do everything" agent's successor.
SYSTEM_PROMPT = harness.BUILDER_PROMPT


def _model() -> OpenAIModel:
    return OpenAIModel(
        client_args={"api_key": config.NEBIUS_API_KEY, "base_url": config.BASE_URL},
        model_id=config.MODEL_ID,
        params={"max_tokens": config.MAX_TOKENS},
        context_window_limit=config.CONTEXT_WINDOW,
    )


def _session_manager(session_id: str):
    """Chat history store: local files (dev, single worker host) or S3 (several worker hosts)."""
    if config.SESSIONS_S3_BUCKET:
        from strands.session.s3_session_manager import S3SessionManager

        return S3SessionManager(session_id=session_id, bucket=config.SESSIONS_S3_BUCKET,
                                prefix=config.SESSIONS_S3_PREFIX, region_name=config.AWS_REGION)
    return FileSessionManager(session_id=session_id, storage_dir=config.SESSIONS_DIR)


def _set_aside_s3_session(session_id: str) -> None:
    """S3 equivalent of renaming a stale session directory: move its objects under stale-<ts>/."""
    import boto3

    s3 = boto3.client("s3", region_name=config.AWS_REGION)
    src = f"{config.SESSIONS_S3_PREFIX}session_{session_id}/"
    dst = f"{config.SESSIONS_S3_PREFIX}stale-{int(time.time())}/session_{session_id}/"
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=config.SESSIONS_S3_BUCKET, Prefix=src):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            s3.copy_object(Bucket=config.SESSIONS_S3_BUCKET, Key=dst + key[len(src):],
                           CopySource={"Bucket": config.SESSIONS_S3_BUCKET, "Key": key})
            s3.delete_object(Bucket=config.SESSIONS_S3_BUCKET, Key=key)


def build_agent(ctx: RunContext, role: str = "builder") -> Agent:
    # Chat history per project and role. A new Agent with the same session_id restores the
    # earlier conversation, so "now add login" has context. The builder keeps the original
    # session id so projects created before the harness keep their history.
    session_id = ctx.sandbox_id if role == "builder" else f"{ctx.sandbox_id}-{role}"
    session_manager = _session_manager(session_id)

    # Long builds: summarise the oldest part of the conversation before the context window
    # fills up (proactive), instead of failing or losing the thread. The plan files and
    # progress.md carry the durable state, so a summary is enough for older turns.
    conversation_manager = SummarizingConversationManager(
        summary_ratio=0.4,
        preserve_recent_messages=12,
        proactive_compression={"compression_threshold": 0.7},
    )

    def on_event(**kwargs):
        # Forward model text; tool events are emitted by the tools themselves (tools.py).
        if "data" in kwargs:
            ctx.emit_text(kwargs["data"])

    prompt = harness.PLANNER_PROMPT if role == "planner" else harness.BUILDER_PROMPT
    model_id = config.PLANNER_MODEL_ID if role == "planner" and config.PLANNER_MODEL_ID else None
    model = _model()
    if model_id:
        model.update_config(model_id=model_id)

    def make(sm):
        return Agent(
            model=model,
            system_prompt=prompt.format(preview_port=config.PREVIEW_PORT),
            tools=build_tools(ctx, role),
            callback_handler=on_event,
            session_manager=sm,
            conversation_manager=conversation_manager,
        )

    try:
        return make(session_manager)
    except ValueError as e:
        # A session saved by a different conversation manager (projects from before the
        # harness used a sliding window) can't be restored. Keep it aside and start fresh:
        # the plan files and progress.md in the workspace carry the project's state.
        if "conversation manager state" not in str(e):
            raise
        if config.SESSIONS_S3_BUCKET:
            _set_aside_s3_session(session_id)
        else:
            old = os.path.join(config.SESSIONS_DIR, f"session_{session_id}")
            if os.path.isdir(old):
                os.replace(old, f"{old}.stale-{int(time.time())}")
        return make(_session_manager(session_id))
