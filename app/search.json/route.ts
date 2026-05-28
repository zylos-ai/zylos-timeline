import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

export const dynamic = "force-static";

const search = createFromSource(source, {
  language: "english",
  localeMap: {
    zh: "english",
  },
});

export const GET = search.staticGET;
