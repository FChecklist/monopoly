-- Floor 0004: privacy of machine-API data (DPDP) and a resumable human accept.
-- ai_request.person_id: the person a request is about (by id, never by e-mail), so an erased person's requests can be scrubbed.
-- ai_request.run_state: NULL (nothing to run), 'running' (an accepted event.submit is not finished; it can be resumed), 'done'.
-- api_idem.subject: ',id1,id2,' of the people a stored answer is about, so the stored body can be dropped when a person is erased.
ALTER TABLE ai_request ADD COLUMN person_id TEXT;
ALTER TABLE ai_request ADD COLUMN run_state TEXT;
UPDATE ai_request SET person_id = json_extract(payload, '$.person_id') WHERE json_valid(payload) AND json_type(payload, '$.person_id') = 'text';
CREATE INDEX IF NOT EXISTS air_person ON ai_request(company_id, person_id);
ALTER TABLE api_idem ADD COLUMN subject TEXT;
