-- 0096 rollback — drop the watcher/recent-search functions and tables.
--
-- Functions first (they are separate objects; dropping the table does not cascade to them), then
-- the tables. IF EXISTS throughout so a partial forward-apply still rolls back cleanly. App code
-- fail-softs on the absent-relation/function class (42P01/3F000/42883), so rolling back degrades
-- the board's watcher + recent panels to session-only rather than 500ing.

set role claims_admin;

drop function if exists claims.save_qualify_watcher(uuid, text, text, text, text, int);
drop function if exists claims.delete_qualify_watcher(uuid, bigint);
drop function if exists claims.record_qualify_recent_search(uuid, text, text, text);
drop function if exists claims.clear_qualify_recent_searches(uuid);

drop table if exists claims.qualify_watcher;
drop table if exists claims.qualify_recent_search;

reset role;
