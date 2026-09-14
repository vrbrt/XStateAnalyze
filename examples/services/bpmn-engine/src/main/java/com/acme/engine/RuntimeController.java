package com.acme.engine;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/runtime")
public class RuntimeController {
  private final ProcessRuntime runtime;

  public RuntimeController(ProcessRuntime runtime) { this.runtime = runtime; }

  @PostMapping("/process-instances")
  public ProcessInstance startProcessInstance(@RequestBody StartRequest request) {
    return runtime.start(request.processKey());
  }

  @GetMapping("/process-instances/{id}")
  public ProcessInstance getProcessInstance(@PathVariable String id) {
    return runtime.find(id);
  }

  @PostMapping("/tasks/{id}/complete")
  public void completeTask(@PathVariable String id) {
    runtime.complete(id);
  }
}
