"""Seed or promote an admin account (plan T3).

Usage:
    uv run python scripts/create_admin.py --email ops@example.com --password s3cret

Inserts the user, or updates the existing user's role/password when the email
already exists. Run `alembic upgrade head` first so the users table exists.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.api.auth.security import hash_password  # noqa: E402
from src.storage.database import get_session  # noqa: E402
from src.storage.models import UserRecord  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or promote an admin user")
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument(
        "--role",
        default="admin",
        choices=["admin", "operator", "viewer"],
        help="Role to assign (default: admin)",
    )
    args = parser.parse_args()

    session = get_session()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == args.email).first()
        if user is None:
            user = UserRecord(email=args.email, role=args.role, is_active=True)
            session.add(user)
            action = "created"
        else:
            action = "updated"

        user.password_hash = hash_password(args.password)
        user.role = args.role
        user.is_active = True
        session.commit()
        print(f"{action} user {user.email} with role {user.role}")
        return 0
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
