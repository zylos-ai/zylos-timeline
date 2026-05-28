import ResearchDetailPage, {
  generateMetadata as generateLocalizedMetadata,
  generateStaticParams,
} from "../../../[locale]/research/[slug]/page";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  return generateLocalizedMetadata({
    params: Promise.resolve({ locale: "en", slug }),
  });
}

export { generateStaticParams };

export async function Page({ params }: PageProps) {
  const { slug } = await params;
  return (
    <ResearchDetailPage
      params={Promise.resolve({ locale: "en", slug })}
    />
  );
}

export default Page;
