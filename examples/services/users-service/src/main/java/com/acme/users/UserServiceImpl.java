package com.acme.users;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import java.util.List;
import java.util.Optional;

@Service
public class UserServiceImpl implements UserService {
  private final UserRepository repository;
  private final NotificationGateway notifications;
  private final List<UserValidator> validators;
  private final KafkaTemplate<String, String> kafka;
  @Value("${users.topic}")
  private String usersTopic;

  public UserServiceImpl(UserRepository repository, NotificationGateway notifications, List<UserValidator> validators, KafkaTemplate<String, String> kafka) {
    this.repository = repository;
    this.notifications = notifications;
    this.validators = validators;
    this.kafka = kafka;
  }

  @Override
  public List<UserDto> findAll() {
    return repository.findAll().stream().map(UserMapper::toDto).toList();
  }

  @Override
  public Optional<UserDto> findById(Long id) {
    return repository.findById(id).map(UserMapper::toDto);
  }

  @Override
  public UserDto create(UserDto dto) {
    validators.forEach(v -> v.validate(dto));
    UserEntity saved = repository.save(UserMapper.toEntity(dto));
    kafka.send(usersTopic, saved.getId().toString());
    notifications.notify(saved.getEmail(), "Welcome");
    return UserMapper.toDto(saved);
  }

  @Override
  public void delete(Long id) {
    repository.deleteById(id);
    kafka.send(usersTopic, "deleted:" + id);
  }
}
