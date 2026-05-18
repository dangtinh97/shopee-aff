import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFirstLink } from "@/lib/links";
import { RedirectView } from "./RedirectView";

export async function generateMetadata(): Promise<Metadata> {
  const link = await getFirstLink();

  if (!link) {
    return {
      title: "Không tìm thấy link",
      description: "Datasource chưa có link nào.",
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  return {
    title: link.title,
    description: link.description,
    openGraph: {
      title: link.title,
      description: link.description,
      images: [
        {
          url: link.image,
          alt: link.title,
        },
      ],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: link.title,
      description: link.description,
      images: [link.image],
    },
  };
}

export default async function RedirectFirstPage() {
  const link = await getFirstLink();

  if (!link) {
    notFound();
  }

  return <RedirectView link={link} />;
}
