import type { CollectionEntry } from "astro:content";
import { slugifyStr } from "./slugify";
import postFilter from "./postFilter";

export interface Series {
  series: string;
  seriesName: string;
  count: number;
}

const getUniqueSeries = (posts: CollectionEntry<"blog">[]): Series[] => {
  const seriesMap = new Map<string, { seriesName: string; count: number }>();

  posts
    .filter(postFilter)
    .filter(post => post.data.series) // Only posts with series
    .forEach(post => {
      const seriesName = post.data.series!;
      const seriesSlug = slugifyStr(seriesName);

      if (seriesMap.has(seriesSlug)) {
        seriesMap.get(seriesSlug)!.count++;
      } else {
        seriesMap.set(seriesSlug, { seriesName, count: 1 });
      }
    });

  return Array.from(seriesMap.entries())
    .map(([series, { seriesName, count }]) => ({
      series,
      seriesName,
      count,
    }))
    .sort((a, b) => a.seriesName.localeCompare(b.seriesName));
};

export default getUniqueSeries;
