"""
CVA Tool FastAPI Backend -- placeholder.
Full implementation coming in Part C.
"""
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health() -> dict:
    """Health check endpoint."""
    return {"status": "ok"}
