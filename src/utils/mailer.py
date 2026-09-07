"""Outbound email delivery for verification and recovery flows (stdlib smtplib).

When no SMTP host is configured, delivery is skipped and the caller is told
so it can fall back to server-side logging for operator retrieval.
"""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from typing import Any

from src.utils.logging import get_logger

logger = get_logger(__name__)


def send_email(
    settings: Any,
    *,
    to: str,
    subject: str,
    body: str,
) -> bool:
    """Send a plaintext email; returns True when accepted by the SMTP server."""
    host = str(getattr(settings, "smtp_host", "") or "").strip()
    if not host:
        logger.info("SMTP not configured; skipping email to %s (%s)", to, subject)
        return False
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = str(getattr(settings, "smtp_from", "") or host)
    message["To"] = to
    message.set_content(body)
    port = int(getattr(settings, "smtp_port", 587) or 587)
    username = str(getattr(settings, "smtp_username", "") or "")
    password = str(getattr(settings, "smtp_password", "") or "")
    use_tls = bool(getattr(settings, "smtp_use_tls", True))
    try:
        with smtplib.SMTP(host, port, timeout=15) as client:
            if use_tls:
                client.starttls(context=ssl.create_default_context())
            if username:
                client.login(username, password)
            client.send_message(message)
        return True
    except (smtplib.SMTPException, OSError) as exc:
        logger.warning("SMTP delivery to %s failed: %s", to, exc)
        return False
