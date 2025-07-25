import type { CollectionEntry } from "astro:content";
import getPostsBySeries from "./getPostsBySeries";
import { slugifyStr } from "./slugify";

export interface SeriesNavigation {
  prevPost: CollectionEntry<"blog"> | null;
  nextPost: CollectionEntry<"blog"> | null;
  currentIndex: number;
  totalPosts: number;
  seriesName: string;
}

const getSeriesNavigation = (
  posts: CollectionEntry<"blog">[],
  currentPost: CollectionEntry<"blog">
): SeriesNavigation | null => {
  if (!currentPost.data.series) {
    return null;
  }

  const seriesSlug = slugifyStr(currentPost.data.series);
  const seriesPosts = getPostsBySeries(posts, seriesSlug);

  const currentIndex = seriesPosts.findIndex(
    post => post.id === currentPost.id
  );

  if (currentIndex === -1) {
    return null;
  }

  return {
    prevPost: currentIndex > 0 ? seriesPosts[currentIndex - 1] : null,
    nextPost:
      currentIndex < seriesPosts.length - 1
        ? seriesPosts[currentIndex + 1]
        : null,
    currentIndex: currentIndex + 1, // 1-based index for display
    totalPosts: seriesPosts.length,
    seriesName: currentPost.data.series,
  };
};

export default getSeriesNavigation;
