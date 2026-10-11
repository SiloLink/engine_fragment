import { RefreshViewRequest } from "../protocol";
import { MultiThreadingRequestClass } from "../../model/model-types";
import { MultithreadingHelper } from "../multithreading-helper";
import { ThreadController } from "./thread-controller";

export class ThreadViewRefresher extends ThreadController {
  protected getId() {
    return MultiThreadingRequestClass.REFRESH_VIEW;
  }

  protected async execute(input: RefreshViewRequest) {
    const model = this.thread.list.get(input.modelId);
    if (model) {
      const { view } = input;
      model.refreshView({
        ...view,
        cameraFrustum: view.cameraFrustum
          ? MultithreadingHelper.frustum(view.cameraFrustum)
          : null,
        cameraPosition: MultithreadingHelper.array(view.cameraPosition),
        clippingPlanes: MultithreadingHelper.planeSet(view.clippingPlanes),
        modelPlacement: MultithreadingHelper.transform(view.modelPlacement),
      });
    }
  }
}
