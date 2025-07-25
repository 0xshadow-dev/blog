import type { CollectionEntry } from "astro:content";
import { slugifyStr } from "./slugify";
import postFilter from "./postFilter";

const getPostsBySeries = (
  posts: CollectionEntry<"blog">[],
  series: string
): CollectionEntry<"blog">[] => {
  return posts
    .filter(postFilter)
    .filter(post => post.data.series && slugifyStr(post.data.series) === series)
    .sort((a, b) => {
      // Sort by seriesOrder if available, otherwise by publication date
      const orderA = a.data.seriesOrder ?? 999;
      const orderB = b.data.seriesOrder ?? 999;

      if (orderA !== orderB) {
        return orderA - orderB;
      }

      // If same order (or both undefined), sort by date
      return a.data.pubDatetime.getTime() - b.data.pubDatetime.getTime();
    });
};

export default getPostsBySeries;
