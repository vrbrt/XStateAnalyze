package com.acme.engine;

import org.springframework.stereotype.Service;

@Service
public class ProcessRuntime {
  public ProcessInstance start(String key) { return new ProcessInstance("1", key); }
  public ProcessInstance find(String id) { return new ProcessInstance(id, "?"); }
  public void complete(String taskId) { }
}
