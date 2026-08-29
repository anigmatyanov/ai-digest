/**
 * The package's public surface — and deliberately nothing per-connector.
 *
 * Adding a connector must not require editing a shared file: that is the whole reason
 * `registry.ts` is generated. A line like `export { rssConnector } from "./rss/index.js"`
 * here would put the hotspot back one package below the one E-006 removed from
 * profiles/schema.ts — every connector epic would touch this file, and the epics would
 * have to be serialised again.
 *
 * Consumers reach a connector through `getConnector(kind)`, never by importing its symbol.
 * Measured 2026-08-29: nothing outside this package imported `rssConnector`,
 * `RssConfigSchema` or `RssCursorSchema` — the rss test imports them relative, from
 * `./index.js` inside its own directory.
 *
 * `index.test.ts` next to this file holds the line: it fails if any export or import here
 * resolves to anything but `./registry.js`.
 */

export { connectors, getConnector, sourceVariants } from "./registry.js";
export type { ConnectorKind } from "./registry.js";
