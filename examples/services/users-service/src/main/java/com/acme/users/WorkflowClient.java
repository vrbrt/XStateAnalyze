package com.acme.users;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import com.acme.generated.workflow.api.RuntimeApi;
import com.acme.generated.workflow.model.CompleteTaskRequest;

/** BFF-style client for the workflow engine: three call styles, none of which name the engine's application name. */
@Component
public class WorkflowClient {
  private final RestTemplate restTemplate;
  private final WebClient.Builder webClientBuilder;
  private final RuntimeApi runtimeApi;

  @Value("${workflow.engine-url}")
  private String engineUrl;

  public WorkflowClient(RestTemplate restTemplate, WebClient.Builder webClientBuilder, RuntimeApi runtimeApi) {
    this.restTemplate = restTemplate;
    this.webClientBuilder = webClientBuilder;
    this.runtimeApi = runtimeApi;
  }

  public String startOnboarding(Long userId) {
    // gateway prefix /engine is not part of the engine's own routes
    return restTemplate.postForObject(engineUrl + "/engine/runtime/process-instances", new StartBody("onboarding", userId), String.class);
  }

  public String status(String instanceId) {
    return webClientBuilder.baseUrl(engineUrl).build().get().uri("/engine/runtime/process-instances/{id}", instanceId).retrieve().bodyToMono(String.class).block();
  }

  public void completeTask(String taskId) {
    runtimeApi.completeTaskWithHttpInfo(taskId, new CompleteTaskRequest());
  }
}
