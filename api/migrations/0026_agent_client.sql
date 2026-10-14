-- The MCP client an agent runs in (its MCP `clientInfo`, e.g. claude-code), as
-- last reported by the OTPilot MCP server: shown in the extension.
ALTER TABLE agents ADD COLUMN client TEXT, ADD COLUMN client_version TEXT;
