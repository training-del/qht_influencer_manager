-- Phone numbers gained a country code, stored separately from the 10-digit
-- national number so validation can differ per country.
--
-- Previously applied by addColumnIfMissing() at startup; a database created
-- before migrations existed is baselined and will not replay this.
ALTER TABLE users ADD COLUMN country_code TEXT NOT NULL DEFAULT '+91';
