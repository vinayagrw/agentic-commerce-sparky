"""B13 triage: concurrent identical zero-result searches file ONE record (check-then-insert is atomic)."""
import threading


def test_concurrent_file_triage_dedupes(tmp_path, monkeypatch):
    monkeypatch.setenv("SHOP_DB_PATH", str(tmp_path / "c.db"))
    from shop_mcp import db, storefront
    with db.connect():
        pass
    ids, errs = [], []

    def go():
        try:
            ids.append(storefront.file_triage("pb race", {"brand": ["Zzz"]}, "4108", "s1", {}))
        except Exception as e:  # pragma: no cover - surfaced below
            errs.append(e)

    ts = [threading.Thread(target=go) for _ in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errs and len(set(ids)) == 1
    with db.connect() as c:
        assert c.execute("SELECT COUNT(*) FROM triage WHERE query='pb race'").fetchone()[0] == 1
