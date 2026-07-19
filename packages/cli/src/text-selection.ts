export interface TextCell {
  startOffset: number;
  endOffset: number;
}

export interface TextSelectionRange {
  startOffset: number;
  endOffset: number;
}

/** Selection coordinates are offsets in the unwrapped plain document. */
export class TextSelectionModel {
  private anchor?: TextCell;
  private focus?: TextCell;
  private selecting = false;

  get dragging(): boolean {
    return this.selecting;
  }

  get active(): boolean {
    return Boolean(this.anchor && this.focus);
  }

  begin(cell: TextCell): void {
    this.anchor = cell;
    this.focus = cell;
    this.selecting = true;
  }

  update(cell: TextCell): void {
    if (!this.anchor || !this.selecting) {
      return;
    }
    this.focus = cell;
  }

  finish(cell?: TextCell): void {
    if (cell) {
      this.update(cell);
    }
    this.selecting = false;
  }

  clear(): void {
    this.anchor = undefined;
    this.focus = undefined;
    this.selecting = false;
  }

  range(): TextSelectionRange | undefined {
    if (!this.anchor || !this.focus) {
      return undefined;
    }

    if (this.focus.startOffset < this.anchor.startOffset) {
      return {
        startOffset: this.focus.startOffset,
        endOffset: this.anchor.endOffset
      };
    }
    return {
      startOffset: this.anchor.startOffset,
      endOffset: this.focus.endOffset
    };
  }

  selectedText(document: string): string {
    const range = this.range();
    if (!range || range.endOffset <= range.startOffset) {
      return '';
    }
    return document.slice(range.startOffset, range.endOffset);
  }
}
