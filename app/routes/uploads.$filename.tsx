import type { LoaderFunctionArgs } from "react-router";
import { readUpload } from "~/services/storage.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const found = await readUpload(String(params.filename || ""));
  if (!found) {
    throw new Response("Not found", { status: 404 });
  }
  return new Response(found.data as unknown as BodyInit, {
    headers: {
      "Content-Type": found.type,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
