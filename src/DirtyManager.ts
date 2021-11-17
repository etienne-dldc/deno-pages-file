export class DirtyManager {
  private isDirty: boolean;

  constructor(isDirty: boolean = false) {
    this.isDirty = isDirty;
  }

  public get dirty() {
    return this.isDirty;
  }

  public markClean() {
    this.isDirty = false;
  }

  public markDirty() {
    this.isDirty = true;
  }
}
