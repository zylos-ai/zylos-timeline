import DocsPage, {
  generateMetadata as generateLocalizedMetadata,
} from "../../../[locale]/docs/[[...slug]]/page";
import { source } from "@/lib/source";

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export function generateStaticParams() {
  return source
    .generateParams("slug", "locale")
    .filter((params) => params.locale === "en")
    .map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  return generateLocalizedMetadata({
    params: Promise.resolve({ locale: "en", slug }),
  });
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  return <DocsPage params={Promise.resolve({ locale: "en", slug })} />;
}
