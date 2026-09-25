// Two levels up: this route sits in its own directory, and `app/` is one above
// that. (A one-level import compiles in the editor and fails only at build
// time, which is why this tree builds before it ships.)
import { merchantRedirect } from "../../services/seller.server";

/**
 * The address Shopify loads the app at, and the first hop of every session.
 *
 * This route deliberately authenticates nothing: it runs before there is a
 * session to authenticate, and its whole job is to hand the request on to the
 * merchant app with the frame context intact. That context — `shop`, `host`,
 * `embedded` and, after a bounce, `id_token` — is what the next request is
 * authenticated by, so it is carried over by the same helper every other
 * internal merchant redirect uses rather than by a hand-built query string that
 * a later edit could quietly drop.
 *
 * A request that arrives with no context is passed on unchanged. That is the
 * genuine external visit — someone opening the app URL on its own — and it is
 * the one case where the merchant app has nothing to authenticate and says so.
 */
export const loader = async ({ request }) => {
  throw merchantRedirect(request, "/app/application");
};

export default function App() {
  return null;
}
