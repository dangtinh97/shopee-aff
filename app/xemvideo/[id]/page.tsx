import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAllLinkIds, getLinkById } from "@/lib/links";
import { RedirectView } from "../RedirectView";

type PageProps = {
  params: Promise<{
    id: string;
  }>;
};

export async function generateStaticParams() {
  const ids = await getAllLinkIds();

  return ids.map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const link = await getLinkById(id);

  if (!link) {
    return {
      title: "Khong tim thay link",
      description: "Link này không tồn tại hoặc đã bị xóa.",
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

export default async function RedirectPage({ params }: PageProps) {
  const { id } = await params;
  const link = await getLinkById(id);

  if (!link) {
    notFound();
  }

  return <RedirectView link={link} />;
}
