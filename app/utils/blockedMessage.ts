/**
 * What a blocked store is told.
 *
 * WHY THIS IS NOT IN seller.server.ts. It used to be, and that was a build
 * failure waiting to happen: the layout's error boundary renders this sentence
 * in the browser, and a route module can only have server imports stripped from
 * its `loader`, `action`, `middleware` and `headers` exports. Any other export
 * that touches a `.server` module drags the whole module — Prisma included —
 * into the client bundle, and the build refuses.
 *
 * A sentence is not server code. Keeping it in a module both sides may import
 * is the fix, and `seller.server.ts` re-exports it so the two dozen server
 * call sites keep reading as they did.
 *
 * It deliberately says nothing about why, what was sold, or what happens next.
 * A block is the owner's decision and the reasoning is theirs to give; a screen
 * that improvises an explanation invents a policy.
 */
export const BLOCKED_MESSAGE = "This app is not available for your store.";
