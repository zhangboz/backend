# Retired local export implementation

Archived on 2026-11-04 when document generation moved to OpenAI Responses + Code Interpreter.
These files and the Word template are preserved for reference only. They are not imported by the application, installed as workers, or included in the production image. Their BullMQ/Redis/Pandoc/TeX dependencies are no longer installed. Use `services/openaiExports.mjs` for the active implementation.

Old local files and Redis volumes remain untouched. Previous native-conversion tests are retained locally under ignored `.local/legacy-pandoc-tests/`.
