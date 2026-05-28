import LandingPage, {
  generateMetadata as generateLocalizedMetadata,
} from "../[locale]/page";

const params = Promise.resolve({ locale: "en" });

export function generateMetadata() {
  return generateLocalizedMetadata({ params });
}

export default function Page() {
  return <LandingPage params={params} />;
}
