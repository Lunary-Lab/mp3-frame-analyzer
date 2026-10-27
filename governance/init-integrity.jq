length > 1 and .[0].type == "version" and .[0].terraform == env.TERRAFORM_VERSION and
all(.[]; type == "object" and .["@level"] == "info" and .["@module"] == "terraform.ui" and
  (.type | type == "string" and length > 0) and (.["@message"] | type == "string") and .type != "diagnostic") and
any(.[]; .type == "init_output" and .message_code == "output_init_success_message")
