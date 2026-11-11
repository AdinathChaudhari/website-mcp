# test/fixtures/tools/

Sample browser tools used by the tests. The fixture site binds an ephemeral port, so a tool's
`site.allowedOrigins` and URL literals use the placeholder `__ORIGIN__`. `test/helpers/index.mjs`
(`installFixtureTool`) copies the folder into a temp home with `__ORIGIN__` replaced by the live
`http://127.0.0.1:<port>`. `allowedOrigins` is still enforced: the tool may only reach that origin.
