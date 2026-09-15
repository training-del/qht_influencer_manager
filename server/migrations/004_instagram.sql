-- The influencer's Instagram handle, taken at registration (optional) and
-- editable by them from "My details". Stored without the "@".
ALTER TABLE users ADD COLUMN instagram_id TEXT;
