/** Shared shape between the plugin's extractor and the server's index. */
export interface ScreenRecord {
  id: string;
  name: string;
  type: string;
  pageId: string;
  pageName: string;
  sectionName?: string;
  path: string;
  width: number;
  height: number;
  text: string;
  textNodes: number;
  instanceCount: number;
  componentKeys: string[];
  componentNames: string[];
}

export interface GraphChunk {
  pages: { id: string; name: string; index: number; screens: number }[];
  screens: ScreenRecord[];
  components: { key: string; name: string; instances: number; screens: number }[];
  nextPage: number | null;
  totalPages: number;
  stats: Record<string, number>;
}
