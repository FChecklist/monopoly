-- Each claim of a provider operation carries a token; only the worker that holds it may record the answer.
ALTER TABLE provider_op ADD COLUMN claim_token TEXT;
