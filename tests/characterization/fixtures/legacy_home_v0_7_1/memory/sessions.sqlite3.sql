BEGIN TRANSACTION;
CREATE TABLE sessions (
                        id TEXT PRIMARY KEY,
                        space TEXT NOT NULL,
                        project TEXT NOT NULL,
                        provider TEXT NOT NULL,
                        native_session_id TEXT,
                        owner_type TEXT NOT NULL,
                        owner_id TEXT,
                        status TEXT NOT NULL,
                        title TEXT,
                        cwd TEXT,
                        parent_session_id TEXT,
                        manifest_path TEXT NOT NULL UNIQUE,
                        last_event_seq INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
INSERT INTO "sessions" VALUES('cleo_9a0dfe9ca97d','non_productivity','general','cleo',NULL,'user',NULL,'completed','Weekly plan','{{HOME}}',NULL,'{{HOME}}\memory\non_productivity\projects\general\sessions\cleo_9a0dfe9ca97d\manifest.json',9,'2026-10-03T23:10:28.869172+00:00','2026-10-03T23:10:32.239556+00:00');
INSERT INTO "sessions" VALUES('cleo_03dfeadcefad','non_productivity','research','cleo',NULL,'user',NULL,'completed','Collect reading notes','{{RESEARCH}}',NULL,'{{HOME}}\memory\non_productivity\projects\research\sessions\cleo_03dfeadcefad\manifest.json',4,'2026-10-03T23:10:32.865858+00:00','2026-10-03T23:10:33.180387+00:00');
INSERT INTO "sessions" VALUES('agent_38adcdaedba4','productivity','workspace','scripted','acp-session-1','agent',NULL,'completed','Write the notes file [[plan]] [[tool]] [[write]]','{{WORKSPACE}}',NULL,'{{HOME}}\memory\productivity\projects\workspace\sessions\agent_38adcdaedba4\manifest.json',17,'2026-10-03T23:10:33.987008+00:00','2026-10-03T23:10:35.951113+00:00');
CREATE INDEX idx_sessions_scope
                        ON sessions(space, project, status, updated_at);
CREATE INDEX idx_sessions_native
                        ON sessions(provider, native_session_id);
COMMIT;
