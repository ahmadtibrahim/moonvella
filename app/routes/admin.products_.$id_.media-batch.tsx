import type { ActionFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { permissionsFor } from "~/services/permissions";
import { uploadMediaBatch } from "~/services/media.server";

/**
 * The batch uploader's own endpoint, and why it is not the editor's action.
 *
 * THIS ROUTE HAS NO COMPONENT, AND THAT IS THE WHOLE POINT. React Router picks
 * how to answer a POST by looking at the request path and the matched route,
 * and it never consults a header:
 *
 *   pathname ends in `.data`          -> single fetch; the action's result is
 *                                        serialised into React Router's own
 *                                        turbo-stream envelope, and the
 *                                        response is `text/x-script`
 *   route has no default export       -> resource route; the action's Response
 *                                        is returned to the caller VERBATIM
 *   anything else                     -> a rendered document
 *
 * The uploader is a raw XMLHttpRequest doing `JSON.parse(responseText)`. Against
 * the page's own path it got HTML; against the `.data` twin it gets
 * `[{"_1":2},"data",{"_3":4},"ok",true,...]` — which parses, to an ARRAY, so
 * `answer.ok` is `undefined` and every file is reported as failed while the
 * asset is in fact stored. Both were measured against the running app; the
 * earlier note in the uploader assuming `.data` was the answer was wrong, and
 * the loop it produced is the same one the HTML version produced.
 *
 * A resource route is the one arrangement where `Response.json(...)` reaches the
 * caller unchanged, so that is what this is. Nothing here is an internal
 * detail of the router that can move under us: "a route without a component
 * returns its Response directly" is the documented contract for resource routes,
 * and it is what the framework's own dispatch checks for.
 *
 * `admin.products_.$id_.media-batch` — the trailing underscore on `$id` keeps
 * this out of the editor's route tree. It is an endpoint the editor calls, not a
 * screen nested inside it, and a route that renders nothing should not be
 * reachable through the route that renders the product.
 *
 * OLD BUNDLES ARE UNAFFECTED. A tab still holding the previous bundle posts
 * `media_upload_batch` to the editor's own action, and that case still exists
 * there and still does the same work through the same shared function.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "products.manage");
  const { ip, userAgent } = getRequestMeta(request);

  const form = await request.formData();
  const outcome = await uploadMediaBatch(String(params.id), form, {
    actorType: "ADMIN_USER" as const,
    actorId: user.id,
    actorName: user.name,
    ipAddress: ip,
    userAgent,
    permissions: [...permissionsFor(user.role)],
  });

  // 200 for every outcome, including the refusals — see the note on
  // BatchUploadOutcome: a non-2xx would be read by the uploader as the
  // connection failing rather than as an answer about the file.
  return Response.json(outcome);
}
