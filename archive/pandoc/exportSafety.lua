-- Pandoc's PDF pipeline can fetch images outside its --sandbox boundary.
-- This application exports answer text/math/tables/code, not embedded media.
-- Reject image nodes before writers can read a local path or fetch a URL.
function Image(_)
  error('EXPORT_EXTERNAL_RESOURCE_BLOCKED', 0)
end
