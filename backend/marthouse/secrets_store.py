"""Warehouse passwords and Git tokens.

Local mode keeps them in the macOS Keychain (any OS keyring via `keyring`).
Hosted mode encrypts them with Fernet and stores them in the database.
Secrets are only ever handed to dbt as environment variables of the job process.
"""
from __future__ import annotations

from cryptography.fernet import Fernet
from sqlalchemy.orm import Session

from .config import get_settings
from .models import Secret

SERVICE = "Marthouse"


def _fernet() -> Fernet:
    s = get_settings()
    key = s.secret_key
    if not key:
        f = s.data_dir / "secret.key"
        if not f.exists():
            f.write_bytes(Fernet.generate_key())
            f.chmod(0o600)
        key = f.read_text(encoding="utf-8").strip()
    return Fernet(key.encode() if isinstance(key, str) else key)


def _use_keyring() -> bool:
    if get_settings().hosted:
        return False
    try:
        import keyring
        from keyring.backends import fail

        return not isinstance(keyring.get_keyring(), fail.Keyring)
    except Exception:
        return False


def set_secret(db: Session, ws: str, key: str, value: str) -> str:
    """Returns where it was stored: 'keychain' or 'encrypted'."""
    if _use_keyring():
        import keyring

        keyring.set_password(SERVICE, f"{ws}:{key}", value)
        return "keychain"
    token = _fernet().encrypt(value.encode()).decode()
    row = db.get(Secret, (ws, key))
    if row:
        row.ciphertext = token
    else:
        db.add(Secret(workspace_id=ws, key=key, ciphertext=token))
    db.commit()
    return "encrypted"


def get_secret(db: Session, ws: str, key: str) -> str | None:
    if _use_keyring():
        import keyring

        v = keyring.get_password(SERVICE, f"{ws}:{key}")
        if v is not None:
            return v
    row = db.get(Secret, (ws, key))
    if not row:
        return None
    return _fernet().decrypt(row.ciphertext.encode()).decode()


def has_secret(db: Session, ws: str, key: str) -> bool:
    return get_secret(db, ws, key) is not None


def delete_secret(db: Session, ws: str, key: str) -> None:
    if _use_keyring():
        import keyring

        try:
            keyring.delete_password(SERVICE, f"{ws}:{key}")
        except Exception:
            pass
    row = db.get(Secret, (ws, key))
    if row:
        db.delete(row)
        db.commit()


def where() -> str:
    return "keychain" if _use_keyring() else "encrypted"
