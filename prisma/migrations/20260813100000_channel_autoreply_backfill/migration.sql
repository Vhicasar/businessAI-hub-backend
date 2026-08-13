-- Preserve each channel's existing auto-reply behaviour.
--
-- Auto-reply used to live in metadata.autoReply, where a missing value meant
-- OFF (the read was `if (!autoReply) return;`). The new column defaults to true
-- for newly connected channels, so without this backfill every existing channel
-- that had never enabled auto-reply would start answering customers by itself.
UPDATE "ChannelAccount"
SET "autoReply" = COALESCE(("metadata" ->> 'autoReply')::boolean, false);
