"""Unit tests for the VOB sync's Monday paging — stdlib unittest only, no new dependency
(the repo's node:test rule covers TypeScript; this is the one Python module with a live cron).

Run:  cd etl/vob && python -m unittest test_vob_cron_sync -v
CI:   a step in .github/workflows/vob-sync.yml, before the sync itself.

These lock in the fix for the 2026-08-03 defect: Monday's items(ids:) carries a default
limit of 25, so 50-id chunks silently returned half their ids. The dropped items were
never inserted, stayed "new", and were re-dropped next run — surfacing as a large, stable
`no_pdf` count that read like an attachment problem rather than a paging bug.

No network, no DB, no secrets: `monday` is replaced with a fake. INDEX_HMAC_KEY is a
throwaway all-zero test key needed only because vob_blind_index derives its key at import.
"""
import json
import os
import unittest

os.environ.setdefault("INDEX_HMAC_KEY", "00" * 32)   # not a secret — import-time requirement only
os.environ.setdefault("MONDAY_API_TOKEN", "test-token")

import vob_cron_sync as v


def _files_value(asset_id):
    """The shape Monday returns in a files4 column value."""
    return json.dumps({"files": [{"assetId": asset_id}]})


class FakeMonday:
    """Stands in for vob_cron_sync.monday. Records every call so the test can assert the
    request shape, and optionally TRUNCATES the items() response to `cap` ids to reproduce
    the real API's default page limit."""

    def __init__(self, item_ids, cap=None, unattached=()):
        self.item_ids = list(item_ids)
        self.cap = cap
        self.unattached = set(unattached)
        self.calls = []

    def __call__(self, query, variables=None):
        variables = variables or {}
        self.calls.append((query, variables))
        if "assets(" in query:
            return {"assets": [{"id": a, "public_url": f"https://example.invalid/{a}"}
                               for a in variables["ids"]]}
        requested = [i for i in variables["ids"] if i in self.item_ids]
        served = requested[: self.cap] if self.cap is not None else requested
        return {"items": [
            {"id": i,
             "column_values": [{"value": None if i in self.unattached else _files_value(f"a{i}")}]}
            for i in served
        ]}


class AssetUrlsPaging(unittest.TestCase):
    def setUp(self):
        self._real_monday = v.monday
        self.addCleanup(lambda: setattr(v, "monday", self._real_monday))

    def _ids(self, n):
        return [str(1000 + i) for i in range(n)]

    def test_items_query_requests_an_explicit_limit(self):
        """The bug was relying on the server default. The limit must be sent, and must cover
        the chunk — otherwise the tail of every chunk is dropped again."""
        ids = self._ids(50)
        v.monday = FakeMonday(ids)
        v.asset_urls(ids)
        item_calls = [(q, vars_) for q, vars_ in v.monday.calls if "assets(" not in q]
        self.assertTrue(item_calls, "expected at least one items() call")
        for query, variables in item_calls:
            self.assertIn("limit:$lim", query, "items() must pass an explicit limit")
            self.assertEqual(variables["lim"], v.ITEM_CHUNK)
            self.assertGreaterEqual(variables["lim"], len(variables["ids"]))

    def test_all_ids_are_requested_across_chunks(self):
        ids = self._ids(120)
        v.monday = FakeMonday(ids)
        urls, seen = v.asset_urls(ids)
        requested = [i for q, vars_ in v.monday.calls if "assets(" not in q for i in vars_["ids"]]
        self.assertCountEqual(requested, ids)
        self.assertEqual(seen, set(ids))
        self.assertEqual(set(urls), set(ids))

    def test_chunks_never_exceed_the_declared_limit(self):
        """A chunk larger than the limit is the original bug. Guard the invariant directly."""
        ids = self._ids(137)
        v.monday = FakeMonday(ids)
        v.asset_urls(ids)
        for query, variables in v.monday.calls:
            if "assets(" not in query:
                self.assertLessEqual(len(variables["ids"]), v.ITEM_CHUNK)

    def test_truncated_ids_are_excluded_from_seen(self):
        """If the API ever silently caps again, the dropped ids must be absent from `seen` so
        the caller counts them as api_missing instead of folding them into no_pdf."""
        ids = self._ids(50)
        v.monday = FakeMonday(ids, cap=25)          # reproduce the real default limit
        urls, seen = v.asset_urls(ids)
        self.assertEqual(len(seen), 25)
        self.assertEqual(len(urls), 25)
        dropped = set(ids) - seen
        self.assertEqual(len(dropped), 25)
        for iid in dropped:
            self.assertNotIn(iid, urls)

    def test_unattached_item_is_seen_but_yields_no_url(self):
        """The genuine no_pdf case: the API returned the item, it just has no files4 yet.
        It must be in `seen` so it is NOT miscounted as an API truncation."""
        ids = self._ids(10)
        v.monday = FakeMonday(ids, unattached={ids[3], ids[7]})
        urls, seen = v.asset_urls(ids)
        self.assertEqual(seen, set(ids))
        self.assertNotIn(ids[3], urls)
        self.assertNotIn(ids[7], urls)
        self.assertEqual(len(urls), 8)

    def test_empty_input_makes_no_calls(self):
        v.monday = FakeMonday([])
        urls, seen = v.asset_urls([])
        self.assertEqual(urls, {})
        self.assertEqual(seen, set())
        self.assertEqual(v.monday.calls, [])


if __name__ == "__main__":
    unittest.main()
