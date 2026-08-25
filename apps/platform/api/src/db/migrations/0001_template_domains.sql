-- Domain separation for templates: NULL = shared across all domains, set =
-- visible/usable only for that sending domain. Slugs stay globally unique
-- (no table rebuild on live instances); ownership is enforced in code.
ALTER TABLE templates ADD COLUMN domain_id TEXT REFERENCES domains(id);
