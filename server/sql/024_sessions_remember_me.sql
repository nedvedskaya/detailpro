-- Remember-me flag for server-side sessions.
-- Existing sessions stay non-remembered; new logins with the checkbox enabled
-- get a longer idle timeout in server/lib/auth.cjs.

ALTER TABLE saas_meta.sessions
  ADD COLUMN IF NOT EXISTS remember_me BOOLEAN NOT NULL DEFAULT FALSE;
