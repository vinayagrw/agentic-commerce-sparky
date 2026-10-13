"""SQLite state shared by the MCP server (stdio) and the HTTP side app."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

# src/shop_mcp/db.py -> parents[4] == sparky-next root
ROOT = Path(__file__).resolve().parents[4]

SCHEMA = """
CREATE TABLE IF NOT EXISTS cart_items (
  session_id TEXT, product_id TEXT, title TEXT, price REAL, qty INTEGER,
  PRIMARY KEY (session_id, product_id));
CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, budget REAL);
CREATE TABLE IF NOT EXISTS mandates (mandate_id TEXT PRIMARY KEY, session_id TEXT,
  body TEXT, status TEXT, created_at REAL, decided_at REAL);
CREATE TABLE IF NOT EXISTS agent_calls (agent_id TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS audit (ts REAL, kind TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS quarantine (session_id TEXT, product_id TEXT, ts REAL, signals TEXT);
CREATE TABLE IF NOT EXISTS guard_events (id TEXT PRIMARY KEY, ts REAL, session_id TEXT, tool TEXT,
  kind TEXT, product_id TEXT, qty INTEGER, reason TEXT);
-- B15 synthetic catalogue services (price/promo, per-store inventory, eligibility) + storefront state
CREATE TABLE IF NOT EXISTS cs_price (product_id TEXT PRIMARY KEY, list_price REAL, price REAL, promo TEXT,
  override_price REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS cs_inventory (product_id TEXT, store_id TEXT, qty INTEGER, override_qty INTEGER,
  updated_at REAL, PRIMARY KEY (product_id, store_id));
CREATE TABLE IF NOT EXISTS cs_eligibility (product_id TEXT PRIMARY KEY, body TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS cs_faults (service TEXT PRIMARY KEY, down INTEGER, until REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS triage (id TEXT PRIMARY KEY, ts REAL, kind TEXT, query TEXT, filters TEXT, store_id TEXT,
  session_id TEXT, relaxation TEXT, status TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS session_store (session_id TEXT PRIMARY KEY, store_id TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS shopping_lists (session_id TEXT, name TEXT, created_at REAL, PRIMARY KEY (session_id, name));
CREATE TABLE IF NOT EXISTS shopping_list_items (session_id TEXT, name TEXT, product_id TEXT, title TEXT, added_at REAL,
  PRIMARY KEY (session_id, name, product_id));
CREATE TABLE IF NOT EXISTS orders (order_id TEXT PRIMARY KEY, session_id TEXT, mandate_id TEXT UNIQUE, body TEXT,
  created_at REAL, status TEXT);
-- B16 shopper accounts, wallet, simulated authorisation. ALL SYNTHETIC.
CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, name TEXT, email TEXT, prefs TEXT, label TEXT,
  synthetic INTEGER, created_at REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS session_account (session_id TEXT PRIMARY KEY, account_id TEXT, updated_at REAL);
-- payment_methods: DELIBERATELY NO PAN COLUMN. There is no column here (and nowhere else in this
-- schema) that can hold a card number: `last4` is copied from the frozen payments.CARD_PROFILES
-- constant, never from any input, and the digits a caller posts are looked up and discarded.
CREATE TABLE IF NOT EXISTS payment_methods (pm_id TEXT PRIMARY KEY, account_id TEXT, kind TEXT, brand TEXT,
  last4 TEXT, exp_month INTEGER, exp_year INTEGER, token TEXT, outcome TEXT, balance REAL, label TEXT,
  is_default INTEGER, synthetic INTEGER, created_at REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS addresses (address_id TEXT PRIMARY KEY, account_id TEXT, name TEXT, line1 TEXT, line2 TEXT,
  city TEXT, region TEXT, postal_code TEXT, store_id TEXT, instructions TEXT, label TEXT, is_default INTEGER,
  synthetic INTEGER, created_at REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS payment_attempts (attempt_id TEXT PRIMARY KEY, mandate_id TEXT, session_id TEXT,
  account_id TEXT, tender_hash TEXT, amount REAL, decision TEXT, reason TEXT, auth_ref TEXT, step_up_id TEXT,
  detail TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS step_ups (step_up_id TEXT PRIMARY KEY, session_id TEXT, mandate_id TEXT, pm_id TEXT,
  amount REAL, code TEXT, attempts INTEGER, max_attempts INTEGER, expires_at REAL, status TEXT, created_at REAL);
"""


def db_path() -> Path:
    return Path(os.environ.get("SHOP_DB_PATH") or ROOT / "data" / "commerce.db")


def connect() -> sqlite3.Connection:
    p = db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


# CREATE TABLE IF NOT EXISTS never adds a column to a table that already exists, and data/commerce.db
# is live demo state we do not drop. Every column added after a table shipped goes here instead.
ADDED_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "orders": [("account_id", "TEXT"), ("address_id", "TEXT"), ("auth_ref", "TEXT")],
}


def _migrate(conn: sqlite3.Connection) -> None:
    """Idempotent: adds any column in ADDED_COLUMNS that the live table is missing."""
    for table, cols in ADDED_COLUMNS.items():
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if not have:
            continue  # table absent entirely (should not happen: SCHEMA just ran)
        for name, decl in cols:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
