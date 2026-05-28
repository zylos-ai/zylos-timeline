import TimelinePage, { metadata } from "../../[locale]/timeline/page";

const params = Promise.resolve({ locale: "en" });

export { metadata };

export default function Page() {
  return <TimelinePage params={params} />;
}
