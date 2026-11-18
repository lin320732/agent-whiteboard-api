# Vendored Markdown parser

`markdown-it.mjs` is the unmodified, self-contained browser ES module from
`markdown-it@15.0.3`, licensed under MIT. Its license is in `markdown-it.LICENSE`;
bundled dependency notices are in `THIRD_PARTY_LICENSES.md`.
The board serves this asset locally; there is no runtime CDN dependency.

- Upstream: https://github.com/markdown-it/markdown-it
- npm release: https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.3.tgz
- npm archive integrity: `sha512-+Az7Ojz3iRGu8KYMvJ6xVhvrxP3eE+vEtJX75Ow88XBpcQNV/0lGX5ZynIIBftREo4DC2jsveAMDaeltmm8QvQ==`
- Archive entry: `package/dist/browser/markdown-it.esm.min.mjs`
- Asset SHA-256: `d5432491790141da046b1197353705db03264f40b5727f3b4b591f5aba193e30`

To update, download a pinned npm archive, verify its registry integrity, and copy
the browser module and license. Run the Markdown unit and browser tests afterward.
The upstream source-map comment is retained; the optional source map is not shipped.
