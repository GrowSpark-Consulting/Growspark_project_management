import { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3100';

  return [
    { url: baseUrl, lastModified: new Date() },
    { url: `${baseUrl}/login`, lastModified: new Date() },
    { url: `${baseUrl}/signup`, lastModified: new Date() },
  ];
}
