"""Typed worker failures.

A worker failure must reach the operator as a stable code plus a sentence a
person can act on, never as a Python traceback or the last two kilobytes of a
tool's stderr. `code` is the contract; `message` is for people.
"""
from __future__ import annotations


class WorkerError(Exception):
    def __init__(self, code: str, message: str, status: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def as_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}
