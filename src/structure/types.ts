/** A directed file->file structural relationship, e.g. an import edge. */
export interface FileEdge {
  fromPath: string;
  toPath: string;
  kind: string;
}
